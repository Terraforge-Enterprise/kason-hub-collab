// Owner-Billing fee-config create/edit drawer (M6). FormDrawer (Sheet) +
// controlled FormState that resets on open (admin-form-drawer pattern). Carries
// a LIVE SST PREVIEW that runs computeManagementFee client-side as the operator
// edits, so the effective % and the SST breakdown are visible BEFORE saving.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Receipt } from "lucide-react";
import {
  computeManagementFee,
  type FeeType,
  type ManagementFeeConfig,
} from "@kason/shared";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Callout } from "@/components/ui/callout";
import { Field, SelectInput, TextInput } from "@/components/form-ui";
import {
  useCreateFeeConfig,
  useUpdateFeeConfig,
  type FeeConfigRow,
} from "@/api/owner-billing";

export type OwnerOption = { id: string; displayName: string };
export type PropertyOption = { id: string; name: string };

export type FeeConfigDrawerProps = {
  open: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  config?: FeeConfigRow;
  owners: OwnerOption[];
  properties: PropertyOption[];
  /** When set (owner-detail context), the owner is fixed: the select is replaced
   * by read-only text and the form's ownerPartyId is forced to this owner. */
  lockedOwner?: OwnerOption;
};

type FormState = {
  ownerPartyId: string;
  propertyId: string; // "" = All properties
  feeType: FeeType;
  feeValue: string;
  capAmount: string;
  sstPercent: string;
  freePeriodStart: string; // yyyy-mm-dd from <input type="date">; "" = none
  freePeriodEnd: string;
};

type FormErrors = Partial<Record<"ownerPartyId" | "feeValue" | "capAmount", string>>;

// Sample rent the live preview is computed against (RM). Round number so the
// breakdown reads cleanly, e.g. "10.8% → RM216 on RM2,000 rent".
const SAMPLE_RENT = "2000";

function blankForm(): FormState {
  return {
    ownerPartyId: "",
    propertyId: "",
    feeType: "percent",
    feeValue: "",
    capAmount: "",
    sstPercent: "8", // matches managementFeeConfigInput default
    freePeriodStart: "",
    freePeriodEnd: "",
  };
}

function formFromConfig(c: FeeConfigRow): FormState {
  return {
    ownerPartyId: c.ownerPartyId,
    propertyId: c.propertyId ?? "",
    feeType: c.feeType,
    feeValue: c.feeValue,
    capAmount: c.capAmount ?? "",
    sstPercent: c.sstPercent,
    freePeriodStart: c.freePeriodStart ? c.freePeriodStart.slice(0, 10) : "",
    freePeriodEnd: c.freePeriodEnd ? c.freePeriodEnd.slice(0, 10) : "",
  };
}

/** yyyy-mm-dd → Z-normalized ISO at UTC midnight (the API's zod .datetime() rejects offsets). */
function toIsoFromDateInput(value: string): string {
  return new Date(`${value}T00:00:00Z`).toISOString();
}

// A non-negative money/percent decimal string with at most 2 dp (mirrors the
// shared decimalString domain). Used to guard the live preview AND submit.
const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

export function FeeConfigDrawer({
  open,
  onClose,
  mode,
  config,
  owners,
  properties,
  lockedOwner,
}: FeeConfigDrawerProps) {
  const createConfig = useCreateFeeConfig();
  const updateConfig = useUpdateFeeConfig();

  const [form, setForm] = useState<FormState>(() => blankForm());
  const [errors, setErrors] = useState<FormErrors>({});

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset-on-open form snapshot; same pattern as TaskDrawer / admin-form-drawer.
      if (mode === "edit" && config) setForm(formFromConfig(config));
      else setForm(lockedOwner ? { ...blankForm(), ownerPartyId: lockedOwner.id } : blankForm());
      setErrors({});
    }
    // config is captured at open time only (keyed on config?.id) — re-snapshotting
    // on every config object identity change would clobber in-progress edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, config?.id, lockedOwner?.id]);

  function set<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  // ── Live SST preview ─────────────────────────────────────────────────────
  // computeManagementFee is the SAME shared function the backend uses, so the
  // preview is exact — no drift. Guard every input first: an in-progress/empty
  // value would make computeManagementFee throw, so we only run it once the
  // relevant fields parse.
  const preview = useMemo<
    | { ok: true; label: string; total: string; base: string; sst: string }
    | { ok: false; reason: string }
  >(() => {
    if (!DECIMAL_RE.test(form.feeValue)) {
      return { ok: false, reason: "Enter a fee value to preview the SST breakdown." };
    }
    if (!DECIMAL_RE.test(form.sstPercent)) {
      return { ok: false, reason: "Enter an SST % to preview the breakdown." };
    }
    if (form.feeType === "cap" && !DECIMAL_RE.test(form.capAmount)) {
      return { ok: false, reason: "Enter a cap amount to preview the capped fee." };
    }
    const cfg: ManagementFeeConfig = {
      feeType: form.feeType,
      feeValue: form.feeValue,
      capAmount: form.feeType === "cap" ? form.capAmount : null,
      sstPercent: form.sstPercent,
    };
    try {
      const r = computeManagementFee(cfg, SAMPLE_RENT);
      return { ok: true, label: r.effectivePercentLabel, total: r.total, base: r.base, sst: r.sst };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "Invalid configuration." };
    }
  }, [form.feeType, form.feeValue, form.capAmount, form.sstPercent]);

  function handleSubmit() {
    const errs: FormErrors = {};
    if (!form.ownerPartyId) errs.ownerPartyId = "Owner is required.";
    if (!DECIMAL_RE.test(form.feeValue)) errs.feeValue = "Enter a non-negative value (max 2 dp).";
    if (form.feeType === "cap" && !DECIMAL_RE.test(form.capAmount)) {
      errs.capAmount = "Cap amount is required for a capped fee.";
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const capAmount = form.feeType === "cap" ? form.capAmount : null;
    const freePeriodStart = form.freePeriodStart ? toIsoFromDateInput(form.freePeriodStart) : null;
    const freePeriodEnd = form.freePeriodEnd ? toIsoFromDateInput(form.freePeriodEnd) : null;
    const propertyId = form.propertyId || null;

    if (mode === "create") {
      createConfig.mutate(
        {
          ownerPartyId: form.ownerPartyId,
          propertyId,
          feeType: form.feeType,
          feeValue: form.feeValue,
          capAmount,
          sstPercent: form.sstPercent,
          freePeriodStart,
          freePeriodEnd,
        },
        {
          onSuccess: () => {
            toast.success("Fee config created.");
            onClose();
          },
          onError: (err) => toast.error(err.message),
        },
      );
      return;
    }

    if (!config) return;
    // PATCH every editable field plus the optimistic-concurrency token. Sending
    // the full set (not a diff) is safe — the service writes only what changed.
    updateConfig.mutate(
      {
        id: config.id,
        expectedUpdatedAt: config.updatedAt,
        ownerPartyId: form.ownerPartyId,
        propertyId,
        feeType: form.feeType,
        feeValue: form.feeValue,
        capAmount,
        sstPercent: form.sstPercent,
        freePeriodStart,
        freePeriodEnd,
      },
      {
        onSuccess: () => {
          toast.success("Fee config updated.");
          onClose();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  const isPending = createConfig.isPending || updateConfig.isPending;

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      size="lg"
      title={mode === "create" ? "New fee config" : "Edit fee config"}
      description={
        mode === "create"
          ? "Set an owner's management fee. SST is added per row at the rate you choose."
          : "Update this owner's management fee. The live preview reflects unsaved edits."
      }
      onSubmit={handleSubmit}
      submit={{
        label: mode === "create" ? "Create config" : "Save changes",
        pendingLabel: mode === "create" ? "Creating…" : "Saving…",
        variant: "gold",
        pending: isPending,
      }}
    >
      <div className="grid gap-4">
        <Field label="Owner" error={errors.ownerPartyId}>
          {lockedOwner ? (
            <div
              aria-label="Owner"
              className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm text-foreground"
            >
              {lockedOwner.displayName}
            </div>
          ) : (
            <SelectInput
              value={form.ownerPartyId}
              onChange={(e) => set("ownerPartyId", e.target.value)}
              aria-label="Owner"
            >
              <option value="">Select an owner…</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.displayName}
                </option>
              ))}
            </SelectInput>
          )}
        </Field>

        <Field
          label="Property scope"
          hint="Leave as All properties to apply the fee to every property this owner holds."
        >
          <SelectInput
            value={form.propertyId}
            onChange={(e) => set("propertyId", e.target.value)}
            aria-label="Property scope"
          >
            <option value="">All properties</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectInput>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Fee type">
            <SelectInput
              value={form.feeType}
              onChange={(e) => set("feeType", e.target.value as FeeType)}
              aria-label="Fee type"
            >
              <option value="percent">Percent of rent</option>
              <option value="fixed">Fixed RM</option>
              <option value="cap">Capped percent</option>
            </SelectInput>
          </Field>
          <Field
            label={form.feeType === "fixed" ? "Fee amount (RM)" : "Fee value (%)"}
            error={errors.feeValue}
          >
            <TextInput
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.feeValue}
              onChange={(e) => set("feeValue", e.target.value)}
              placeholder={form.feeType === "fixed" ? "e.g. 250" : "e.g. 10"}
            />
          </Field>
        </div>

        {form.feeType === "cap" && (
          <Field
            label="Cap amount (RM)"
            hint="The fee is capped at this RM amount even when the percent would be higher."
            error={errors.capAmount}
          >
            <TextInput
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.capAmount}
              onChange={(e) => set("capAmount", e.target.value)}
              placeholder="e.g. 500"
            />
          </Field>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="SST %" hint="Default 8% (current Malaysian rate).">
            <TextInput
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.sstPercent}
              onChange={(e) => set("sstPercent", e.target.value)}
              placeholder="8"
            />
          </Field>
          {/* Cleaning auto-bill was REMOVED here (2026-08-17). The bills grid owns
              cleaning end to end — the unit Setting drawer sets the bearer and the
              Recurring editor sets the amount — so a second cleaning amount in owner
              settings only ever competed with them. Its automatic statement issuer had
              already been deleted on 2026-07-29 for double-billing the same
              apartment-month; this removes the leftover field and its manual endpoint. */}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Free period start" hint="No management fee charged within this window.">
            <TextInput
              type="date"
              value={form.freePeriodStart}
              onChange={(e) => set("freePeriodStart", e.target.value)}
            />
          </Field>
          <Field label="Free period end">
            <TextInput
              type="date"
              value={form.freePeriodEnd}
              onChange={(e) => set("freePeriodEnd", e.target.value)}
            />
          </Field>
        </div>

        {/* LIVE SST PREVIEW — runs computeManagementFee (shared) on a sample rent. */}
        {preview.ok ? (
          <Callout variant="info" title="Live SST preview">
            <span data-testid="sst-preview">
              {form.feeType === "fixed" ? (
                <>
                  RM{form.feeValue} + {preview.label} ={" "}
                  <span className="font-semibold">RM{preview.total}</span> per statement
                </>
              ) : (
                <>
                  {form.feeValue}% + {form.sstPercent}% SST ={" "}
                  <span className="font-semibold">{preview.label}</span> → RM{preview.total} on
                  RM{Number(SAMPLE_RENT).toLocaleString("en-MY")} rent
                </>
              )}
            </span>
            <span className="mt-1 block text-xs opacity-80">
              Base RM{preview.base} + SST RM{preview.sst}. Worked on a sample RM
              {Number(SAMPLE_RENT).toLocaleString("en-MY")} rent.
            </span>
          </Callout>
        ) : (
          <Callout variant="info" title="Live SST preview">
            <span data-testid="sst-preview-pending" className="inline-flex items-center gap-1.5">
              <Receipt className="h-3.5 w-3.5 shrink-0" />
              {preview.reason}
            </span>
          </Callout>
        )}
      </div>
    </FormDrawer>
  );
}
