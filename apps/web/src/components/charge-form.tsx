/**
 * Shared tenant-charge creation form (accounting-docs P1, spec §4.8).
 *
 * ONE implementation, three mounts: the /billing/charges create card, the
 * tenant-tracker AddFeeDrawer, and (Plan 4) the unit workspace.
 *
 * Flag ON (ENABLE_PHASE2_BILLING_DOCS): free-text chargeType is replaced by a
 * ChargeCategory dropdown grouped by family + a live preview of the routed
 * document ("Will issue a Debit Note in the DEP series."). chargeType mirrors
 * the category CODE and categoryId is sent (the API enforces CATEGORY_REQUIRED).
 * Flag DARK: legacy free-text charge-type input, no category fetch, no
 * categoryId — the old POST body byte-for-byte, so master stays inert.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { ChargeCategoryDto } from "@kason/shared";
import { apiFetch, ApiError } from "@/lib/api-client";
import { isPhase2FlagEnabled } from "@/lib/feature-flags";
import { useChargeCategories } from "@/api/charge-categories";
import {
  ActionButton,
  Field,
  FormCard,
  SelectInput,
  TextAreaInput,
  TextInput,
} from "@/components/form-ui";
import { Callout } from "@/components/ui/callout";

const FAMILY_LABEL: Record<string, string> = {
  tenant_income: "Tenant income (KAEN)",
  owner_income: "Owner income (KAEN)",
  pay_back_landlord: "Pay back to landlord",
};
const FAMILIES = ["tenant_income", "owner_income", "pay_back_landlord"] as const;

const DOC_TYPE_PHRASE: Record<string, string> = {
  invoice: "an Invoice",
  debit_note: "a Debit Note",
};

/**
 * Auto-generated, editable charge number — moved here verbatim from
 * tenant-tracker-drawers.tsx so every ChargeForm mount keeps the CHG- UX.
 */
export function defaultChargeNumber(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `CHG-${ymd}-${rand}`;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function ChargeForm({
  tenancyId,
  unitId,
  defaultPartyId,
  defaultCategoryCode,
  onCreated,
  layout = "card",
}: {
  tenancyId?: string;
  unitId?: string;
  /** Pre-resolved bill-to party (e.g. the room's tenant) — hides the party picker. */
  defaultPartyId?: string;
  defaultCategoryCode?: string;
  onCreated?: (charge: { id: string; chargeNumber: string }) => void;
  layout?: "card" | "drawer";
}) {
  const qc = useQueryClient();
  const flagOn = isPhase2FlagEnabled("ENABLE_PHASE2_BILLING_DOCS");

  const [chargeNumber, setChargeNumber] = useState(defaultChargeNumber);
  const [partyId, setPartyId] = useState(defaultPartyId ?? "");
  const [categoryId, setCategoryId] = useState("");
  const [chargeType, setChargeType] = useState(""); // legacy flag-dark path
  const [amount, setAmount] = useState("");
  const [month, setMonth] = useState(currentMonth);
  const [description, setDescription] = useState("");
  const [pickedTenancyId, setPickedTenancyId] = useState("");
  const [pickedUnitId, setPickedUnitId] = useState("");
  // Spec2 R10a: 409 DUPLICATE_CHARGE renders an inline "already exists"
  // affordance instead of a raw error toast. existingChargeId may be absent
  // (fail-closed race path on the backend) — the link only renders when set.
  const [duplicateCharge, setDuplicateCharge] = useState<{ existingChargeId?: string } | null>(null);

  const categories = useChargeCategories({ enabled: flagOn });
  const items = categories.data?.items ?? [];

  const preselected = useMemo(
    () => (defaultCategoryCode ? items.find((c) => c.code === defaultCategoryCode) : undefined),
    [items, defaultCategoryCode],
  );
  const effectiveCategoryId = categoryId || preselected?.id || "";
  const selected: ChargeCategoryDto | undefined = items.find((c) => c.id === effectiveCategoryId);

  // Bill-to picker — same endpoint + query key as the billing charges page,
  // so the cache is shared with charges-page.tsx.
  const needsPartyPick = !defaultPartyId;
  const tenants = useQuery({
    queryKey: ["parties", "tenants"],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; displayName: string }> }>("/parties/tenants"),
    enabled: needsPartyPick,
  });
  // Optional link pickers: only for the card mount (drawer/workspace mounts
  // are pre-scoped by props; a vacant room passes tenancyId undefined but
  // must NOT offer an org-wide tenancy list — old AddFeeDrawer behavior).
  const showTenancyPicker = layout === "card" && tenancyId === undefined;
  const showUnitPicker = layout === "card" && unitId === undefined;
  const tenancies = useQuery({
    queryKey: ["tenancy", "tenancies"],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; tenancyCode: string; tenantName: string }> }>("/tenancy/tenancies"),
    enabled: showTenancyPicker,
  });
  const units = useQuery({
    queryKey: ["inventory", "units"],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; propertyName: string; unitCode: string }> }>("/inventory/units"),
    enabled: showUnitPicker,
  });

  const createCharge = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch<{ id: string }>("/billing/charges", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (resp, body) => {
      toast.success("Charge created as draft — review it on the Billing page");
      void qc.invalidateQueries({ queryKey: ["billing"] });
      onCreated?.({ id: resp.id, chargeNumber: body.chargeNumber });
      setChargeNumber(defaultChargeNumber());
      setAmount("");
      setDescription("");
    },
    onError: (err) => {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        (err.data as { error?: string } | undefined)?.error === "DUPLICATE_CHARGE"
      ) {
        setDuplicateCharge({
          existingChargeId: (err.data as { existingChargeId?: string } | undefined)?.existingChargeId,
        });
        return;
      }
      toast.error(err instanceof Error ? err.message : "Failed to create charge");
    },
  });

  function submit() {
    // Clear a stale "already exists" banner from a prior attempt — a
    // resubmit (edited or not) always reflects the CURRENT attempt's outcome.
    setDuplicateCharge(null);
    const effectiveTenancyId = tenancyId ?? pickedTenancyId;
    const effectiveUnitId = unitId ?? pickedUnitId;
    createCharge.mutate({
      chargeNumber: chargeNumber.trim(),
      partyId,
      ...(effectiveUnitId ? { unitId: effectiveUnitId } : {}),
      ...(effectiveTenancyId ? { tenancyId: effectiveTenancyId } : {}),
      chargeType: flagOn ? (selected?.code ?? "") : chargeType.trim(),
      ...(flagOn && selected ? { categoryId: selected.id } : {}),
      // Contract "month" field → schema dueDate (1st of the billing month).
      dueDate: `${month}-01`,
      amount,
      ...(description.trim() ? { description: description.trim() } : {}),
      currency: "MYR",
    });
  }

  const canSubmit =
    !!chargeNumber.trim() && !!partyId && !!amount && !!month &&
    (flagOn ? !!selected : !!chargeType.trim());

  const fields = (
    <div className="space-y-4">
      {needsPartyPick && (
        <Field label="Tenant / party">
          <SelectInput value={partyId} onChange={(e) => setPartyId(e.target.value)} required>
            <option value="">Select tenant/party</option>
            {(tenants.data?.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </SelectInput>
        </Field>
      )}
      <Field label="Charge number" hint="Auto-generated — edit if your team uses its own numbering.">
        <TextInput value={chargeNumber} onChange={(e) => setChargeNumber(e.target.value)} required />
      </Field>
      {showTenancyPicker && (
        <Field label="Tenancy">
          <SelectInput value={pickedTenancyId} onChange={(e) => setPickedTenancyId(e.target.value)}>
            <option value="">Link tenancy (optional)</option>
            {(tenancies.data?.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.tenancyCode} · {t.tenantName}
              </option>
            ))}
          </SelectInput>
        </Field>
      )}
      {showUnitPicker && (
        <Field label="Unit">
          <SelectInput value={pickedUnitId} onChange={(e) => setPickedUnitId(e.target.value)}>
            <option value="">Link unit (optional)</option>
            {(units.data?.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.propertyName} · {u.unitCode}
              </option>
            ))}
          </SelectInput>
        </Field>
      )}
      {flagOn ? (
        <Field label="Category">
          <SelectInput value={effectiveCategoryId} onChange={(e) => setCategoryId(e.target.value)} required>
            <option value="">Select category</option>
            {FAMILIES.map((fam) => {
              const group = items.filter((c) => c.family === fam);
              if (group.length === 0) return null;
              return (
                <optgroup key={fam} label={FAMILY_LABEL[fam]}>
                  {group.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </SelectInput>
          {selected ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Will issue {DOC_TYPE_PHRASE[selected.docType]} in the {selected.seriesCode} series.
            </p>
          ) : null}
        </Field>
      ) : (
        <Field label="Charge type">
          <TextInput
            value={chargeType}
            onChange={(e) => setChargeType(e.target.value)}
            placeholder="e.g. access_card, cleaning"
            required
          />
        </Field>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Amount (MYR)">
          <TextInput
            type="number"
            min={0}
            step="0.01"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </Field>
        <Field label="Month" hint="Due on the 1st of this month.">
          <TextInput type="month" value={month} onChange={(e) => setMonth(e.target.value)} required />
        </Field>
      </div>
      <Field label="Description">
        <TextAreaInput
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description shown on the billing ledger"
        />
      </Field>
    </div>
  );

  // Spec2 R10a: inline "already exists" affordance — reuses the app's
  // Callout banner pattern (never a raw error toast for this case).
  const duplicateChargeNotice = duplicateCharge ? (
    <Callout variant="danger" title="Duplicate charge" className="mt-4">
      This charge already exists.
      {duplicateCharge.existingChargeId && (
        <Link
          to={`/billing/charges?focus=${duplicateCharge.existingChargeId}`}
          className="mt-1 inline-block font-medium underline underline-offset-2"
        >
          View the existing charge
        </Link>
      )}
    </Callout>
  ) : null;

  if (layout === "drawer") {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {fields}
        {duplicateChargeNotice}
        <div className="mt-6 flex justify-end">
          <ActionButton type="submit" variant="primary" disabled={!canSubmit || createCharge.isPending}>
            {createCharge.isPending ? "Creating…" : "Create draft charge"}
          </ActionButton>
        </div>
      </form>
    );
  }

  return (
    <FormCard
      title="Create charge"
      description="Creates a draft charge — post it from the register when ready."
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {fields}
      {duplicateChargeNotice}
      <ActionButton type="submit" variant="primary" disabled={!canSubmit || createCharge.isPending}>
        {createCharge.isPending ? "Creating…" : "Create charge"}
      </ActionButton>
    </FormCard>
  );
}
