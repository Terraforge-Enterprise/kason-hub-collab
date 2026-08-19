// Adjustments tab body (invoice-adjustments rework, Change 3). The register of
// existing CN/DN/RN documents linked to this invoice (`detail.relatedDocuments`)
// stays a table: Document · Type · Status · Actions (Void kept from Phase 4.2).
// Below it, an INLINE "add adjustment" row REPLACES the old CreateNoteDrawer
// popup — the drawer is the single container now; nothing pops a separate form.
//
// "View" reuses the SAME open-PDF pattern the drawer's own footer button already
// uses (fetchBillingDocumentPdfUrl → window.open) rather than inventing a nested
// drawer-of-a-drawer navigation stack that doesn't exist elsewhere in this
// codebase — the closest thing to "the note's own detail" without a new
// component class.
//
// Void gating (§4.2): `relatedDocuments[].status` is the LEGACY BillingDocumentStatus
// enum (issued|partially_settled|settled|offset) — it carries no "cancelled" value,
// so a genuinely-voided note still reads back "issued" from a fresh fetch (a known
// backend read-DTO gap; the void write itself is correct and idempotent — voiding an
// already-cancelled note safely no-ops 200). Given that, Void is offered for any
// "issued" row (the only legacy state meaning "still live"; a settled/offset debit
// note IS a genuine downstream-settlement signal for that docType) and hidden the
// moment THIS session successfully voids a row (session-local `voidedIds`) so a
// double-click can't even try. Any state the client didn't anticipate (e.g. a CN
// already fully applied) is still safe: the server's safe-default BLOCK (409
// NOTE_HAS_DOWNSTREAM_SETTLEMENTS) is the authoritative gate, and this component
// surfaces that 409 inline with a clear explanation rather than pretending success.
//
// Create gating (inline add-row): charge-scoped only (spec §7-A1 — no
// invoice-level chargeId=null note here). Amount entry is POSITIVE ONLY — the
// Type dropdown sets the sign server-side; this row never sends a negative
// amount. The Document cell shows a placeholder ("Auto (CN)"/"Auto (DN)") — the
// real number is server-assigned on save via the ReferenceSequence counter;
// there is no peek endpoint, so the number is never fabricated client-side.
// Owner documents get the SAME add-row as tenant docs (seam #4,
// owner-invoice-adjustments-enablement plan — the owner payout correctly nets
// active notes and the frozen-period guard is in place, so the create+void
// 403s were removed). `canCreateNotes` is the only gate; there is no
// separate owner variant to keep in sync.
import { useState } from "react";
import { Loader2, ExternalLink, Ban } from "lucide-react";
import { toast } from "sonner";
import type { BillingDocType, BillingDocumentLineDto, BillingDocumentStatus } from "@kason/shared";
import { adjustmentTargetLines } from "@kason/shared";
import { ApiError } from "@/lib/api-client";
import { TableWrap, DataTable, TableHead, HeadCell, BodyCell, Row, EmptyRow, StatusPill } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Field, SelectInput, TextInput } from "@/components/form-ui";
import { VoidReasonDialog } from "@/components/void-reason-dialog";
import { fetchBillingDocumentPdfUrl, useCreateChargeAdjustment, useVoidChargeAdjustment } from "@/api/billing-documents";
import { formatRM } from "@/components/format";
import { docTypeLabel, humanizeStatus } from "./document-helpers";

export type RelatedDocumentRow = {
  id: string;
  docType: BillingDocType;
  documentNumber: string;
  status: BillingDocumentStatus;
};

type AdjustmentKind = "credit" | "debit";

// Friendly copy for the void route's structured error codes (contract: 409
// NOTE_HAS_DOWNSTREAM_SETTLEMENTS, 400
// NOT_CHARGE_SCOPED/CHARGE_FULLY_CREDITED_USE_CORRECTION). Owner and tenant
// notes both void through this same route (seam #4 removed the owner 403).
const VOID_NOTE_ERROR_COPY: Record<string, string> = {
  NOTE_HAS_DOWNSTREAM_SETTLEMENTS:
    "This note has been applied, paid, or refunded and can't be voided — use the correction flow instead.",
  CHARGE_FULLY_CREDITED_USE_CORRECTION:
    "The linked charge is already fully credited — use the correction flow instead of voiding.",
  NOT_CHARGE_SCOPED: "This document can't be voided here — it isn't linked to a single charge.",
};

function voidNoteErrorMessage(err: Error): string {
  const rawCode =
    err instanceof ApiError && err.data && typeof (err.data as Record<string, unknown>).error === "string"
      ? ((err.data as Record<string, unknown>).error as string)
      : err.message;
  return VOID_NOTE_ERROR_COPY[rawCode] ?? err.message;
}

// Friendly copy for the create-charge-adjustment route's structured error codes
// (contract: 400 CHARGE_NOT_ADJUSTABLE/AMOUNT_INVALID/CREDIT_EXCEEDS_ADJUSTABLE/
// NO_LINKED_INVOICE/CHARGE_IS_SST_SIBLING). Mirrors VOID_NOTE_ERROR_COPY above — the route returns a
// bare { error: CODE }; apiFetch surfaces it as err.message. Owner and tenant
// docs both create through this same route (seam #4 removed the owner 403).
const CREATE_NOTE_ERROR_COPY: Record<string, string> = {
  CHARGE_NOT_ADJUSTABLE: "This charge isn't in an adjustable state right now — refresh and check its status.",
  AMOUNT_INVALID: "Enter an amount greater than zero, with at most 2 decimal places.",
  CREDIT_EXCEEDS_ADJUSTABLE:
    "This credit note would exceed the amount still owed on this line — reduce the amount.",
  NO_LINKED_INVOICE: "Could not find the invoice this charge belongs to — refresh the page and try again.",
  CHARGE_IS_SST_SIBLING:
    "That line is the SST on another charge — adjust the charge itself and its SST moves with the note. Refresh the page to see the current list.",
};

function createNoteErrorMessage(err: Error): string {
  const rawCode =
    err instanceof ApiError && err.data && typeof (err.data as Record<string, unknown>).error === "string"
      ? ((err.data as Record<string, unknown>).error as string)
      : err.message;
  return CREATE_NOTE_ERROR_COPY[rawCode] ?? err.message;
}

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
const amountOk = (v: string) => AMOUNT_RE.test(v) && Number(v) > 0;

/** Inline "add adjustment" row — replaces the old CreateNoteDrawer popup.
 * Charge-scoped only: the line picker is built from the invoice's own
 * charge-backed lines, never chargeId=null. */
function AddAdjustmentRow({ lines }: { lines: BillingDocumentLineDto[] }) {
  // ⚠️ MONEY. `adjustmentTargetLines` also drops the SST siblings the server already
  // moves for us (createChargeAdjustmentService mirrors every note onto them), so the
  // operator cannot relieve the same tax twice — once by picking the "— SST 8%" row,
  // once via the mirror. See that helper's header for the full reasoning; the route
  // rejects the same pick with CHARGE_IS_SST_SIBLING, this only keeps it off screen.
  // Deliberately NOT foldTaxLines: folding hides a tax line whose base is adjusted
  // out of step, which is exactly a line that still needs adjusting by hand.
  const chargeLines = adjustmentTargetLines(lines);
  const createAdjustment = useCreateChargeAdjustment();

  const [type, setType] = useState<AdjustmentKind>("credit");
  const [chargeId, setChargeId] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [touched, setTouched] = useState<{ line?: boolean; description?: boolean; amount?: boolean }>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  function resetRow() {
    setType("credit");
    setChargeId("");
    setDescription("");
    setAmount("");
    setTouched({});
    setSubmitError(null);
  }

  const lineError = touched.line && !chargeId ? "Choose a line to adjust." : undefined;
  // The picked line's own rate — the tax the note will carry onto that charge's SST
  // sibling on its own. Said out loud because the sibling is no longer in the list to
  // pick, and silence there reads as "the SST is being left behind".
  const pickedSstRate = Number(chargeLines.find((l) => l.chargeId === chargeId)?.sstRate ?? 0);
  const lineHint =
    pickedSstRate > 0 ? `SST ${pickedSstRate}% moves with this note automatically.` : undefined;
  const descriptionError =
    touched.description && description.trim().length === 0 ? "Description is required." : undefined;
  const amountError = touched.amount && !amountOk(amount) ? "Enter an amount greater than zero." : (submitError ?? undefined);

  function handleAdd() {
    setTouched({ line: true, description: true, amount: true });
    if (!chargeId || description.trim().length === 0 || !amountOk(amount)) return;
    setSubmitError(null);
    createAdjustment.mutate(
      {
        chargeId,
        kind: type,
        amount,
        description: description.trim(),
        reason: description.trim(),
        idempotencyKey: crypto.randomUUID(),
      },
      {
        onSuccess: (res) => {
          toast.success(`${type === "credit" ? "Credit" : "Debit"} note ${res.data.documentNumber} issued.`);
          resetRow();
        },
        onError: (err: Error) => setSubmitError(createNoteErrorMessage(err)),
      },
    );
  }

  return (
    <div className="rounded-lg border border-border/50 bg-background/40 p-4">
      <h3 className="mb-3 text-sm font-semibold text-foreground">Add adjustment</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-start">
        <Field label="Type">
          <SelectInput aria-label="Type" value={type} onChange={(e) => setType(e.target.value as AdjustmentKind)}>
            <option value="credit">Credit note</option>
            <option value="debit">Debit note</option>
          </SelectInput>
        </Field>

        <Field label="Document" hint="Assigned automatically on save.">
          <div className="flex h-9 items-center rounded-md border border-[var(--input-border)] bg-muted/40 px-3 text-sm text-muted-foreground">
            {type === "credit" ? "Auto (CN)" : "Auto (DN)"}
          </div>
        </Field>

        <Field label="Line item" error={lineError} hint={lineHint}>
          <SelectInput
            aria-label="Line item"
            value={chargeId}
            onChange={(e) => setChargeId(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, line: true }))}
            disabled={chargeLines.length === 0}
          >
            <option value="">Select a line…</option>
            {chargeLines.map((l) => (
              <option key={l.id} value={l.chargeId!}>
                {l.description} — {formatRM(Number(l.originalAmount))}
              </option>
            ))}
          </SelectInput>
        </Field>

        <Field label="Description" error={descriptionError}>
          <TextInput
            aria-label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, description: true }))}
            placeholder="Why is this being adjusted?"
          />
        </Field>

        <Field label="Amount" error={amountError}>
          <TextInput
            aria-label="Amount"
            type="number"
            min={0.01}
            step="0.01"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setSubmitError(null);
            }}
            onBlur={() => setTouched((t) => ({ ...t, amount: true }))}
            placeholder="0.00"
          />
        </Field>
      </div>

      {!chargeLines.length ? (
        <p className="mt-2 text-xs text-rose-600">This invoice has no charge-backed lines — nothing to adjust.</p>
      ) : null}

      <div className="mt-3 flex justify-end">
        <Button type="button" variant="gold" size="sm" disabled={createAdjustment.isPending} onClick={handleAdd}>
          {createAdjustment.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Add
        </Button>
      </div>
    </div>
  );
}

export function AdjustmentsTab({
  relatedDocuments,
  lines,
  counterpartyType,
  canCreateNotes = false,
}: {
  relatedDocuments: RelatedDocumentRow[];
  /** THIS invoice's own lines — the inline add-row's "which line to adjust" picker
   * is built from `lines.filter(l => l.chargeId !== null)`. */
  lines: BillingDocumentLineDto[];
  /** The PARENT invoice's counterparty — create + void now support BOTH tenant and
   * owner (seam #4 removed the owner 403s; spec D5 superseded). */
  counterpartyType?: "tenant" | "owner";
  /** True when the parent doc is a live tenant invoice — gates the inline add-row. */
  canCreateNotes?: boolean;
}) {
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [voidedIds, setVoidedIds] = useState<Set<string>>(new Set());
  const [voidTarget, setVoidTarget] = useState<RelatedDocumentRow | null>(null);
  const [voidError, setVoidError] = useState<string | null>(null);
  const voidNote = useVoidChargeAdjustment();

  async function openNote(id: string) {
    setOpeningId(id);
    try {
      const url = await fetchBillingDocumentPdfUrl(id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't open the document.");
    } finally {
      setOpeningId(null);
    }
  }

  function isVoidable(r: RelatedDocumentRow): boolean {
    return (
      (counterpartyType === "tenant" || counterpartyType === "owner") &&
      r.status === "issued" &&
      !voidedIds.has(r.id)
    );
  }

  function closeVoidDialog() {
    setVoidTarget(null);
    setVoidError(null);
  }

  function confirmVoid(reason: string) {
    const target = voidTarget;
    if (!target) return;
    setVoidError(null);
    voidNote.mutate(
      { id: target.id, reason },
      {
        onSuccess: () => {
          setVoidedIds((prev) => new Set(prev).add(target.id));
          toast.success(`${target.documentNumber} voided.`);
          closeVoidDialog();
        },
        onError: (err: Error) => setVoidError(voidNoteErrorMessage(err)),
      },
    );
  }

  return (
    <div className="space-y-4">
      <TableWrap>
        <DataTable>
          <TableHead>
            <tr>
              <HeadCell>Document</HeadCell>
              <HeadCell>Type</HeadCell>
              <HeadCell>Status</HeadCell>
              <HeadCell className="text-right">Actions</HeadCell>
            </tr>
          </TableHead>
          <tbody>
            {relatedDocuments.length === 0 ? (
              <EmptyRow colSpan={4} label="No linked credit or debit notes." />
            ) : (
              relatedDocuments.map((r) => {
                const voided = voidedIds.has(r.id);
                return (
                  <Row key={r.id}>
                    <BodyCell className="font-semibold text-foreground">{r.documentNumber}</BodyCell>
                    <BodyCell>{docTypeLabel(r.docType)}</BodyCell>
                    <BodyCell>
                      <StatusPill tone={voided ? "rose" : "slate"}>
                        {voided ? "Voided" : humanizeStatus(r.status)}
                      </StatusPill>
                    </BodyCell>
                    <BodyCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={openingId === r.id}
                          onClick={() => openNote(r.id)}
                        >
                          {openingId === r.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ExternalLink className="h-3.5 w-3.5" />
                          )}
                          View
                        </Button>
                        {isVoidable(r) ? (
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            onClick={() => {
                              setVoidTarget(r);
                              setVoidError(null);
                            }}
                          >
                            <Ban className="h-3.5 w-3.5" />
                            Void
                          </Button>
                        ) : null}
                      </div>
                    </BodyCell>
                  </Row>
                );
              })
            )}
          </tbody>
        </DataTable>
      </TableWrap>

      {canCreateNotes ? <AddAdjustmentRow lines={lines} /> : null}

      <VoidReasonDialog
        open={voidTarget !== null}
        title={voidTarget ? `Void ${docTypeLabel(voidTarget.docType)} ${voidTarget.documentNumber}?` : ""}
        body={
          voidError ??
          "This cancels the note and reverses its effect on the linked invoice's balance. This can't be undone from here."
        }
        confirmLabel="Void"
        pending={voidNote.isPending}
        onCancel={closeVoidDialog}
        onConfirm={confirmVoid}
      />
    </div>
  );
}
