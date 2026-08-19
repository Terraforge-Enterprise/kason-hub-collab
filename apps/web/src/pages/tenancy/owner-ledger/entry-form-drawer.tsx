// Owner-Ledger entry create/edit drawer (M6b).
// Mirrors the fee-config-drawer pattern: FormDrawer size="lg", reset-on-open
// useEffect keyed on config?.id, FormErrors partial-record with per-field
// clear, optimistic-concurrency PATCH (expectedUpdatedAt), 409-stale toast.
//
// T3 update: owner → property → unit cascade picker replaces raw UUID text
// inputs. On owner change, useOwnerTree fetches the owner's property+unit tree.
// Property select is disabled until owner is chosen. Unit select is disabled
// until property is chosen. A read-only tenant panel shows once a unit is
// selected. An optional "Apply to" select narrows to a specific room/tenancy.
//
// T3 (paid-by): category drives Paid By + Tax Category via OWNER_CATEGORY_DEFAULTS.
// Operating categories lock Paid By (lock icon + Override affordance); statutory
// categories pre-fill but stay freely editable; Tax Category always editable.
import { useEffect, useRef, useState } from "react";
import { Lock, Paperclip, UploadCloud, X } from "lucide-react";
import { toast } from "sonner";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Callout } from "@/components/ui/callout";
import { Badge } from "@/components/ui/badge";
import { Field, SelectInput, TextAreaInput, TextInput } from "@/components/form-ui";
import { usePhase2AttachmentUpload } from "@/hooks/use-phase2-attachment-upload";
import { cn } from "@/lib/utils";
import {
  useCreateLedgerEntry,
  usePatchLedgerEntry,
  useOwnerTree,
  type OwnerLedgerEntryRow,
  type OwnerTreeUnit,
} from "@/api/owner-ledger";
import {
  OWNER_CATEGORY_DEFAULTS,
  OWNER_LEDGER_CATEGORIES,
  OWNER_PAID_BY,
  OWNER_PAYMENT_STATUSES,
  OWNER_TAX_CATEGORIES,
  type OwnerLedgerCategory,
  type OwnerLedgerDirection,
  type OwnerPaidBy,
  type OwnerPaymentStatus,
  type OwnerTaxCategory,
} from "@kason/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

export type OwnerOption = { id: string; displayName: string };
export type PropertyOption = { id: string; name: string };

export type EntryFormDrawerProps = {
  open: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  entry?: OwnerLedgerEntryRow;
  /** Read-only view: disables every field, hides the submit action, no mutations fire. */
  readOnly?: boolean;
  owners: OwnerOption[];
  /** Pre-select this owner when the drawer opens in create mode. */
  defaultOwnerPartyId?: string;
  /**
   * P4 unit workspace: pre-resolve the full owner→property→unit cascade when
   * the drawer opens in create mode (the workspace already knows all three
   * ids — cascade inverted via Listing.ownerPartyId). Wins over
   * defaultOwnerPartyId. The selects stay editable; changing Owner still
   * resets the cascade downstream exactly as before.
   */
  initialContext?: { ownerPartyId: string; propertyId: string; apartmentId: string };
};

// ─── Form state ───────────────────────────────────────────────────────────────

type FormState = {
  ownerPartyId: string;
  propertyId: string;
  apartmentId: string;
  listingId: string | null;
  tenancyId: string | null;
  statementMonth: string; // YYYY-MM from <input type="month">
  transactionDate: string; // YYYY-MM-DD from <input type="date">
  direction: OwnerLedgerDirection | "";
  category: OwnerLedgerCategory | "";
  amount: string;
  sstAmount: string;
  paidBy: OwnerPaidBy | "";
  paymentStatus: OwnerPaymentStatus | "";
  taxCategory: OwnerTaxCategory | "";
  description: string;
  remarks: string;
  /** Storage keys collected via the entry-attachment upload-url mint. */
  attachmentKeys: string[];
};

type FormErrors = Partial<
  Record<
    | "ownerPartyId"
    | "propertyId"
    | "statementMonth"
    | "transactionDate"
    | "direction"
    | "category"
    | "amount"
    | "paidBy"
    | "overrideReason",
    string
  >
>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function blankForm(): FormState {
  return {
    ownerPartyId: "",
    propertyId: "",
    apartmentId: "",
    listingId: null,
    tenancyId: null,
    statementMonth: "",
    transactionDate: "",
    direction: "",
    category: "",
    amount: "",
    sstAmount: "",
    paidBy: "",
    paymentStatus: "paid",
    taxCategory: "check_with_tax_agent",
    description: "",
    remarks: "",
    attachmentKeys: [],
  };
}

function formFromEntry(e: OwnerLedgerEntryRow): FormState {
  return {
    ownerPartyId: e.ownerPartyId,
    propertyId: e.propertyId,
    apartmentId: e.apartmentId ?? "",
    listingId: e.listingId ?? null,
    tenancyId: e.tenancyId ?? null,
    // statementMonth is stored as ISO date string — take first 7 chars for YYYY-MM
    statementMonth: e.statementMonth ? e.statementMonth.slice(0, 7) : "",
    transactionDate: e.transactionDate ? e.transactionDate.slice(0, 10) : "",
    direction: e.direction,
    category: e.category,
    amount: e.amount,
    sstAmount: e.sstAmount ?? "",
    paidBy: e.paidBy,
    paymentStatus: e.paymentStatus,
    taxCategory: e.taxCategory,
    description: e.description ?? "",
    remarks: e.remarks ?? "",
    attachmentKeys: e.attachmentKeys ?? [],
  };
}

/** Last path segment of a storage key — the human-facing filename. */
function attachmentLabel(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1] || key;
}

/** Humanize a snake_case value: "rental_income" → "Rental Income". */
function humanize(value: string): string {
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Matches non-negative decimal with at most 2 dp, same as shared decimalString.
const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

// ─── Direction options — payout intentionally excluded (API rejects it) ────────

const DIRECTION_OPTIONS: { value: OwnerLedgerDirection; label: string }[] = [
  { value: "income", label: "Income" },
  { value: "expense", label: "Expense" },
];

// ─── Component ────────────────────────────────────────────────────────────────

export function EntryFormDrawer({
  open,
  onClose,
  mode,
  entry,
  readOnly = false,
  owners,
  defaultOwnerPartyId,
  initialContext,
}: EntryFormDrawerProps) {
  const createEntry = useCreateLedgerEntry();
  const patchEntry = usePatchLedgerEntry();

  const [form, setForm] = useState<FormState>(() => blankForm());
  const [errors, setErrors] = useState<FormErrors>({});

  // Paid-by override state — active when admin clicks "Override" on a locked category.
  const [paidByOverrideActive, setPaidByOverrideActive] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");

  // Attachment upload — mint-only (completePath null): client PUTs directly to
  // storage, then submits keys with the form body (no server /complete step).
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachDragOver, setAttachDragOver] = useState(false);
  const upload = usePhase2AttachmentUpload({
    mintPath: "/owner-ledger/entries/attachments/upload-url",
    completePath: null,
    onUploaded: (key) => {
      setForm((prev) => ({
        ...prev,
        attachmentKeys: [...prev.attachmentKeys, key],
      }));
    },
  });

  // Owner tree — only fetches when an owner is selected
  const treeQuery = useOwnerTree(form.ownerPartyId || null);
  const tree = treeQuery.data?.data;

  // Reset form when drawer opens — keyed on entry?.id so mid-edit changes are
  // not clobbered when the same entry is passed with updated props.
  useEffect(() => {
    if (open) {
      if (mode === "edit" && entry) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reset-on-open form snapshot; same pattern as fee-config-drawer.
        setForm(formFromEntry(entry));
      } else {
        // Create mode: seed owner from defaultOwnerPartyId when provided.
        const blank = blankForm();
        if (defaultOwnerPartyId) blank.ownerPartyId = defaultOwnerPartyId;
        // P4: unit workspace pre-resolves the whole cascade (wins over the
        // owner-only default). useOwnerTree then loads this owner's tree, so
        // the Property/Unit selects show their resolved labels.
        if (initialContext) {
          blank.ownerPartyId = initialContext.ownerPartyId;
          blank.propertyId = initialContext.propertyId;
          blank.apartmentId = initialContext.apartmentId;
        }
        setForm(blank);
      }
      setErrors({});
      setPaidByOverrideActive(false);
      setOverrideReason("");
      upload.reset();
    }
    // Keyed on entry?.id only — intentional (mirrors fee-config-drawer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, entry?.id]);

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  // ── Category change handler — applies OWNER_CATEGORY_DEFAULTS ────────────────
  // Always applies in create mode. Also applies in edit mode when the admin
  // actively changes the category (re-deriving from the new selection).

  function handleCategoryChange(newCategory: OwnerLedgerCategory | "") {
    setForm((prev) => {
      const defaults = newCategory ? OWNER_CATEGORY_DEFAULTS[newCategory] : undefined;
      return {
        ...prev,
        category: newCategory,
        paidBy: defaults ? defaults.defaultPaidBy : prev.paidBy,
        taxCategory: defaults ? defaults.defaultTaxCategory : prev.taxCategory,
      };
    });
    setErrors((prev) => ({ ...prev, category: undefined, paidBy: undefined }));
    // Reset override whenever category changes — the new category may be unlocked
    // or have a different lock constraint.
    setPaidByOverrideActive(false);
    setOverrideReason("");
  }

  // ── Cascade helpers ──────────────────────────────────────────────────────────

  // Properties available for the selected owner
  const ownerProperties = tree?.properties ?? [];

  // Units for the selected property
  const selectedProperty = ownerProperties.find((p) => p.id === form.propertyId) ?? null;
  const propertyUnits = selectedProperty?.units ?? [];

  // Selected unit
  const selectedUnit: OwnerTreeUnit | null =
    propertyUnits.find((u) => u.apartmentId === form.apartmentId) ?? null;

  // ── Paid-by lock state ───────────────────────────────────────────────────────

  const categoryDefaults = form.category ? OWNER_CATEGORY_DEFAULTS[form.category] : undefined;
  // A category is locked when its entry exists and paidByLocked === true.
  const isPaidByLocked = !!(categoryDefaults && categoryDefaults.paidByLocked);

  // The field is effectively locked when the category is locked AND the admin has
  // not activated the override affordance.
  const showPaidByLocked = isPaidByLocked && !paidByOverrideActive;

  // ── Submission ──────────────────────────────────────────────────────────────

  function handleSubmit() {
    const errs: FormErrors = {};
    if (!form.ownerPartyId) errs.ownerPartyId = "Owner is required.";
    if (!form.propertyId) errs.propertyId = "Property is required.";
    if (!form.statementMonth) errs.statementMonth = "Statement month is required.";
    if (!form.transactionDate) errs.transactionDate = "Transaction date is required.";
    if (!form.direction) errs.direction = "Direction is required.";
    if (!form.category) errs.category = "Category is required.";
    if (!DECIMAL_RE.test(form.amount)) errs.amount = "Enter a non-negative amount (max 2 dp).";
    if (!form.paidBy) errs.paidBy = "Paid by is required.";
    // Override reason is required when the admin has activated the override.
    if (paidByOverrideActive && !overrideReason.trim()) {
      errs.overrideReason = "Override reason is required.";
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    // Append override reason to remarks when the admin has overridden the lock.
    let remarksValue = form.remarks.trim();
    if (paidByOverrideActive && overrideReason.trim()) {
      const tag = `[paid-by override: ${overrideReason.trim()}]`;
      remarksValue = remarksValue ? `${remarksValue}\n${tag}` : tag;
    }

    const body = {
      ownerPartyId: form.ownerPartyId,
      propertyId: form.propertyId,
      apartmentId: form.apartmentId || null,
      listingId: form.listingId || null,
      tenancyId: form.tenancyId || null,
      // API expects YYYY-MM (shared schema monthString = /^\d{4}-\d{2}$/)
      statementMonth: form.statementMonth,
      transactionDate: form.transactionDate,
      direction: form.direction as OwnerLedgerDirection,
      category: form.category as OwnerLedgerCategory,
      amount: form.amount,
      sstAmount: DECIMAL_RE.test(form.sstAmount) ? form.sstAmount : null,
      paidBy: form.paidBy as OwnerPaidBy,
      paymentStatus: (form.paymentStatus || "paid") as OwnerPaymentStatus,
      taxCategory: (form.taxCategory || "check_with_tax_agent") as OwnerTaxCategory,
      description: form.description.trim() || null,
      remarks: remarksValue || null,
      attachmentKeys: form.attachmentKeys,
    };

    if (mode === "create") {
      createEntry.mutate(body, {
        onSuccess: () => {
          toast.success("Ledger entry created.");
          onClose();
        },
        onError: (err) => toast.error(err.message),
      });
      return;
    }

    if (!entry) return;
    patchEntry.mutate(
      {
        id: entry.id,
        expectedUpdatedAt: entry.updatedAt,
        ...body,
      },
      {
        onSuccess: () => {
          toast.success("Ledger entry updated.");
          onClose();
        },
        onError: (err) => {
          // 409 = stale token — the entry was updated elsewhere; keep drawer open.
          if (err.message.includes("409") || err.message.toLowerCase().includes("conflict")) {
            toast.error("Entry was updated elsewhere. Please review the latest data.");
          } else {
            toast.error(err.message);
          }
        },
      },
    );
  }

  const isPending = createEntry.isPending || patchEntry.isPending;

  // ── Payout hint ─────────────────────────────────────────────────────────────
  // "Counts toward owner payout" when paidBy === "kaen"; else "Recorded for
  // tax only — excluded from payout".
  const payoutHint =
    form.paidBy === "kaen"
      ? "Counts toward owner payout."
      : form.paidBy
        ? "Recorded for tax only — excluded from payout."
        : null;

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="lg"
      title={readOnly ? "Ledger entry" : mode === "create" ? "New ledger entry" : "Edit ledger entry"}
      description={
        readOnly
          ? "Read-only. To change a posted entry, void it and re-add, or edit the source charge/bill."
          : mode === "create"
            ? "Record a manual income or expense entry for an owner."
            : "Update this ledger entry. Optimistic concurrency is enforced — a conflict will prompt you to reload."
      }
      onSubmit={readOnly ? () => {} : handleSubmit}
      submit={
        readOnly
          ? undefined
          : {
              label: mode === "create" ? "Create entry" : "Save changes",
              pendingLabel: mode === "create" ? "Creating…" : "Saving…",
              variant: "gold",
              pending: isPending,
            }
      }
    >
      <fieldset disabled={readOnly} className="contents">
        <div className="grid gap-4">
        {/* ── Owner & Property ─────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Owner" error={errors.ownerPartyId}>
            <SelectInput
              value={form.ownerPartyId}
              onChange={(e) => {
                set("ownerPartyId", e.target.value);
                // Reset cascade downstream
                setForm((prev) => ({
                  ...prev,
                  ownerPartyId: e.target.value,
                  propertyId: "",
                  apartmentId: "",
                  listingId: null,
                  tenancyId: null,
                }));
              }}
              aria-label="Owner"
            >
              <option value="">Select an owner…</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName}
                </option>
              ))}
            </SelectInput>
          </Field>

          <Field label="Property" error={errors.propertyId}>
            <SelectInput
              value={form.propertyId}
              onChange={(e) => {
                // Reset unit + listing/tenancy downstream
                setForm((prev) => ({
                  ...prev,
                  propertyId: e.target.value,
                  apartmentId: "",
                  listingId: null,
                  tenancyId: null,
                }));
                setErrors((prev) => ({ ...prev, propertyId: undefined }));
              }}
              aria-label="Property"
              disabled={!form.ownerPartyId}
            >
              <option value="">Select a property…</option>
              {ownerProperties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>

        {/* ── Unit cascade ───────────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Unit" hint="Optional — narrow to a specific unit.">
            <SelectInput
              value={form.apartmentId}
              onChange={(e) => {
                const aptId = e.target.value;
                setForm((prev) => ({
                  ...prev,
                  apartmentId: aptId,
                  listingId: null,
                  tenancyId: null,
                }));
              }}
              aria-label="Unit"
              disabled={!form.propertyId}
            >
              <option value="">Select a unit…</option>
              {propertyUnits.map((u) => (
                <option key={u.apartmentId} value={u.apartmentId}>
                  {u.unitCode} ({u.listingMode === "WHOLE" ? "Whole" : "Partition"})
                </option>
              ))}
            </SelectInput>
          </Field>

          {/* Apply to — only shown when a unit is selected */}
          {form.apartmentId && selectedUnit && (
            <Field
              label="Apply to"
              hint="Optional — narrow to a specific room/tenant for deposit forfeiture etc."
            >
              <SelectInput
                value={form.listingId ?? ""}
                onChange={(e) => {
                  const listingId = e.target.value || null;
                  if (!listingId) {
                    setForm((prev) => ({ ...prev, listingId: null, tenancyId: null }));
                    return;
                  }
                  // Find the room and link the tenancy if present
                  const room = selectedUnit.rooms.find((r) => r.listingId === listingId) ?? null;
                  setForm((prev) => ({
                    ...prev,
                    listingId,
                    tenancyId: room?.tenancy?.tenancyId ?? null,
                  }));
                }}
                aria-label="Apply to"
              >
                <option value="">Whole unit</option>
                {selectedUnit.rooms.map((room) => (
                  <option key={room.listingId} value={room.listingId}>
                    {room.listingType} — {room.tenancy?.tenantDisplayName ?? "Vacant"}
                  </option>
                ))}
              </SelectInput>
            </Field>
          )}
        </div>

        {/* ── Tenant panel (read-only) ───────────────────────────────────────── */}
        {form.apartmentId && selectedUnit && (
          <Callout variant="info" title="Tenants">
            {selectedUnit.listingMode === "WHOLE" ? (
              // WHOLE unit: show the single room's tenant (or Vacant)
              <div className="text-sm">
                {selectedUnit.rooms[0]?.tenancy?.tenantDisplayName ?? "Vacant"}
              </div>
            ) : (
              // PARTITIONED: show all rooms + tenant names
              <div className="space-y-1">
                {selectedUnit.rooms.map((room) => (
                  <div key={room.listingId} className="flex items-center gap-2 text-sm">
                    <Badge variant="secondary" className="text-xs">{room.listingType}</Badge>
                    <span>{room.tenancy?.tenantDisplayName ?? "Vacant"}</span>
                  </div>
                ))}
              </div>
            )}
          </Callout>
        )}

        {/* ── Dates ─────────────────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Statement month" error={errors.statementMonth}>
            <TextInput
              type="month"
              value={form.statementMonth}
              onChange={(e) => set("statementMonth", e.target.value)}
              aria-label="Statement month"
            />
          </Field>

          <Field label="Transaction date" error={errors.transactionDate}>
            <TextInput
              type="date"
              value={form.transactionDate}
              onChange={(e) => set("transactionDate", e.target.value)}
              aria-label="Transaction date"
            />
          </Field>
        </div>

        {/* ── Direction & Category ─────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Direction"
            hint="Payout entries are managed by the system — only Income and Expense can be entered manually."
            error={errors.direction}
          >
            <SelectInput
              value={form.direction}
              onChange={(e) => set("direction", e.target.value as OwnerLedgerDirection | "")}
              aria-label="Direction"
            >
              <option value="">Select direction…</option>
              {DIRECTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </SelectInput>
          </Field>

          <Field label="Category" error={errors.category}>
            <SelectInput
              value={form.category}
              onChange={(e) => handleCategoryChange(e.target.value as OwnerLedgerCategory | "")}
              aria-label="Category"
            >
              <option value="">Select category…</option>
              {OWNER_LEDGER_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>

        {/* ── Amounts ──────────────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount (RM)" error={errors.amount}>
            <TextInput
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.amount}
              onChange={(e) => set("amount", e.target.value)}
              placeholder="e.g. 1000.00"
              aria-label="Amount"
            />
          </Field>

          <Field label="SST amount (RM)" hint="Leave blank if no SST applies.">
            <TextInput
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.sstAmount}
              onChange={(e) => set("sstAmount", e.target.value)}
              placeholder="e.g. 8.00"
              aria-label="SST amount"
            />
          </Field>
        </div>

        {/* ── Paid by / Payment status / Tax category ───────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-3">
          {/* Paid by — locked for operating categories, editable for statutory/income */}
          <div>
            {showPaidByLocked ? (
              /* Locked display: value + lock icon + Override affordance */
              <Field label="Paid by" error={errors.paidBy}>
                <div className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2 text-sm">
                  <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="flex-1 font-medium">{form.paidBy ? humanize(form.paidBy) : "—"}</span>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-[var(--color-gold,theme(colors.amber.500))] underline hover:no-underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => setPaidByOverrideActive(true)}
                    aria-label="Override paid by"
                  >
                    Override
                  </button>
                </div>
              </Field>
            ) : (
              /* Editable — either unlocked category OR override activated */
              <Field label="Paid by" error={errors.paidBy}>
                <SelectInput
                  value={form.paidBy}
                  onChange={(e) => set("paidBy", e.target.value as OwnerPaidBy | "")}
                  aria-label="Paid by"
                >
                  <option value="">Select…</option>
                  {OWNER_PAID_BY.map((v) => (
                    <option key={v} value={v}>
                      {humanize(v)}
                    </option>
                  ))}
                </SelectInput>
              </Field>
            )}
          </div>

          <Field label="Payment status">
            <SelectInput
              value={form.paymentStatus}
              onChange={(e) => set("paymentStatus", e.target.value as OwnerPaymentStatus)}
              aria-label="Payment status"
            >
              {OWNER_PAYMENT_STATUSES.map((v) => (
                <option key={v} value={v}>
                  {humanize(v)}
                </option>
              ))}
            </SelectInput>
          </Field>

          <Field label="Tax category">
            <SelectInput
              value={form.taxCategory}
              onChange={(e) => set("taxCategory", e.target.value as OwnerTaxCategory)}
              aria-label="Tax category"
            >
              {OWNER_TAX_CATEGORIES.map((v) => (
                <option key={v} value={v}>
                  {humanize(v)}
                </option>
              ))}
            </SelectInput>
          </Field>
        </div>

        {/* ── Override reason — only when override is active on a locked category ─ */}
        {isPaidByLocked && paidByOverrideActive && (
          <Field
            label="Override reason"
            hint="Required — explain why Paid By is being changed from the default."
            error={errors.overrideReason}
          >
            <TextInput
              value={overrideReason}
              onChange={(e) => {
                setOverrideReason(e.target.value);
                setErrors((prev) => ({ ...prev, overrideReason: undefined }));
              }}
              placeholder="e.g. Owner reimbursed KAEN directly this month"
              aria-label="Override reason"
            />
          </Field>
        )}

        {/* ── Payout hint callout ───────────────────────────────────────────── */}
        {payoutHint && (
          <Callout
            variant={form.paidBy === "kaen" ? "success" : "info"}
            title={form.paidBy === "kaen" ? "Counts toward owner payout" : "Excluded from payout"}
          >
            {payoutHint}
          </Callout>
        )}

        {/* ── Description & Remarks ─────────────────────────────────────────── */}
        <Field label="Description" hint="Optional short note (max 500 chars).">
          <TextAreaInput
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="e.g. June rent received"
            maxLength={500}
            aria-label="Description"
          />
        </Field>

        <Field label="Remarks" hint="Optional internal notes (max 500 chars).">
          <TextAreaInput
            value={form.remarks}
            onChange={(e) => set("remarks", e.target.value)}
            placeholder="e.g. Paid via Maybank transfer"
            maxLength={500}
            aria-label="Remarks"
          />
        </Field>

        {/* ── Attachments ──────────────────────────────────────────────────── */}
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium text-foreground">Attachments</p>
            <p className="text-xs text-muted-foreground">
              Optional — attach bill scans or receipts (images/PDFs up to 15 MB).
            </p>
          </div>

          {/* Click-or-drop upload zone — mirrors receipt-uploader.tsx */}
          <button
            type="button"
            disabled={upload.isUploading || readOnly}
            aria-label="Upload bill scans"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              // Note: <fieldset disabled> only suppresses CLICK events on
              // descendant controls, not drag-and-drop — so readOnly must be
              // checked explicitly here too. Skip preventDefault() when
              // readOnly so the browser doesn't treat this as a valid drop
              // target.
              if (readOnly) return;
              e.preventDefault();
              if (!upload.isUploading) setAttachDragOver(true);
            }}
            onDragLeave={() => setAttachDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setAttachDragOver(false);
              if (!upload.isUploading && !readOnly) upload.enqueue(e.dataTransfer.files);
            }}
            className={cn(
              "flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-5 text-center transition-all",
              "border-border/60 bg-background/40 hover:bg-background/60 hover:border-border",
              attachDragOver && "border-[var(--gold)] bg-amber-500/5",
              upload.isUploading && "cursor-not-allowed opacity-60",
            )}
          >
            <UploadCloud className="h-5 w-5 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">
              {upload.isUploading ? "Uploading…" : "Click or drop bill scans to attach"}
            </span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,application/pdf"
            className="hidden"
            aria-hidden="true"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) upload.enqueue(e.target.files);
              e.target.value = "";
            }}
          />

          {/* In-progress upload queue items */}
          {upload.items.filter((i) => i.status !== "done").length > 0 && (
            <div className="space-y-1">
              {upload.items
                .filter((i) => i.status !== "done")
                .map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-sm"
                  >
                    <UploadCloud className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-foreground">{item.file.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {item.status === "error"
                        ? (item.error ?? "Failed")
                        : `${item.progress}%`}
                    </span>
                    {item.status === "error" && (
                      <button
                        type="button"
                        aria-label={`Retry ${item.file.name}`}
                        onClick={() => upload.retry(item.id)}
                        className="text-xs text-amber-600 hover:underline"
                      >
                        Retry
                      </button>
                    )}
                  </div>
                ))}
            </div>
          )}

          {/* Committed attachment keys — mirrors receipt-uploader.tsx badge pattern */}
          {form.attachmentKeys.length > 0 ? (
            <div className="flex flex-wrap gap-2" data-testid="attachment-key-list">
              {form.attachmentKeys.map((key) => (
                <Badge key={key} variant="outline" className="gap-1.5 pr-1">
                  <Paperclip className="h-3 w-3 shrink-0" />
                  <span className="max-w-40 truncate">{attachmentLabel(key)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachmentLabel(key)}`}
                    onClick={() =>
                      setForm((prev) => ({
                        ...prev,
                        attachmentKeys: prev.attachmentKeys.filter((k) => k !== key),
                      }))
                    }
                    className="rounded p-0.5 text-muted-foreground transition hover:bg-rose-500/10 hover:text-rose-600"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No attachments yet.</p>
          )}
        </div>
        </div>
      </fieldset>
    </FormDrawer>
  );
}
