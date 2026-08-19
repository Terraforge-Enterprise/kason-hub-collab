import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ManualInvoiceInput } from "@kason/shared";
import { apiFetch, ApiError } from "@/lib/api-client";
import { FormDrawer } from "@/components/ui/form-drawer";
import { Badge } from "@/components/ui/badge";
import { Field, SelectInput, TextInput } from "@/components/form-ui";
import { useChargeCategories } from "@/api/charge-categories";
import { useCreateManualInvoice } from "@/api/accounting";

/** Family → badge text. DERIVED read-only from the chosen ChargeCategory (R11). */
export function familyBadgeText(family: string | undefined): string | null {
  if (!family) return null;
  return family === "pay_back_landlord" ? "Owner's — pay back" : "KAEN income";
}

type LineDraft = { description: string; categoryId: string; amount: string };
const emptyLine = (): LineDraft => ({ description: "", categoryId: "", amount: "" });
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

type PartyRow = { id: string; displayName: string };
type UnitRow = { id: string; unitCode: string; propertyName: string };

// One shared grid template so the header row and every line row align exactly.
const COL_GRID = "md:grid-cols-[minmax(0,1.5fr)_minmax(0,1.7fr)_minmax(0,0.9fr)_auto]";

export function NewInvoiceDrawer({
  open,
  onClose,
  defaultPartyId,
}: {
  open: boolean;
  onClose: () => void;
  defaultPartyId?: string;
}) {
  const categories = useChargeCategories({ enabled: open });
  const items = categories.data?.items ?? [];
  const byId = useMemo(() => new Map(items.map((c) => [c.id, c])), [items]);

  // When a party is pre-resolved from context, hide the picker (frontend §15).
  const needsPartyPick = !defaultPartyId;
  const [counterpartyType, setCounterpartyType] = useState<"tenant" | "owner">("tenant");
  const [partyId, setPartyId] = useState(defaultPartyId ?? "");
  const [apartmentId, setApartmentId] = useState("");
  const [billingMonth, setBillingMonth] = useState(currentMonth);
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const createInvoice = useCreateManualInvoice();

  // Bill-to + unit are PICKED by name (same endpoints as ChargeForm) — never a
  // typed UUID. The party list follows the Tenant/Owner toggle.
  const parties = useQuery({
    queryKey: ["parties", counterpartyType === "owner" ? "owners" : "tenants"],
    queryFn: () =>
      apiFetch<{ data: PartyRow[] }>(counterpartyType === "owner" ? "/parties/owners" : "/parties/tenants"),
    enabled: open && needsPartyPick,
  });
  const apartments = useQuery({
    queryKey: ["inventory", "apartments"],
    queryFn: () => apiFetch<{ data: UnitRow[] }>("/inventory/apartments"),
    enabled: open && needsPartyPick,
  });

  function pickCounterparty(t: "tenant" | "owner") {
    setCounterpartyType(t);
    setPartyId(""); // the previous selection belonged to the other list
  }
  function setLine(i: number, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function removeLine(i: number) {
    setLines((ls) => (ls.length > 1 ? ls.filter((_, idx) => idx !== i) : ls));
  }

  const canSubmit =
    !!partyId &&
    !!billingMonth &&
    lines.every((l) => l.description.trim() && l.categoryId && /^\d+(\.\d{1,2})?$/.test(l.amount));

  function submit() {
    const body: ManualInvoiceInput = {
      counterpartyType,
      partyId,
      ...(apartmentId ? { apartmentId } : {}),
      billingMonth,
      lines: lines.map((l) => ({ description: l.description.trim(), categoryId: l.categoryId, amount: l.amount })),
    };
    createInvoice.mutate(body, {
      onSuccess: () => {
        toast.success("Invoice issued");
        onClose();
      },
      onError: (err) => toast.error(err instanceof ApiError ? err.message : "Failed to create invoice"),
    });
  }

  return (
    <FormDrawer
      open={open}
      onClose={onClose}
      title="New invoice"
      description="Raise a manual invoice. Each line's family is derived from its category."
      onSubmit={submit}
      submit={{ label: "Issue invoice", pendingLabel: "Issuing…", pending: createInvoice.isPending, disabled: !canSubmit }}
    >
      <div className="space-y-5">
        {needsPartyPick && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Bill to">
              <SelectInput value={counterpartyType} onChange={(e) => pickCounterparty(e.target.value as "tenant" | "owner")}>
                <option value="tenant">Tenant</option>
                <option value="owner">Owner</option>
              </SelectInput>
            </Field>
            <Field label={counterpartyType === "owner" ? "Owner" : "Tenant"}>
              <SelectInput value={partyId} onChange={(e) => setPartyId(e.target.value)} required>
                <option value="">{`Select ${counterpartyType}…`}</option>
                {(parties.data?.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </SelectInput>
            </Field>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {needsPartyPick && (
            <Field label="Unit" hint="Optional — ties the invoice to a unit.">
              <SelectInput value={apartmentId} onChange={(e) => setApartmentId(e.target.value)}>
                <option value="">No unit</option>
                {(apartments.data?.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.propertyName} · {u.unitCode}
                  </option>
                ))}
              </SelectInput>
            </Field>
          )}
          <Field label="Billing month">
            <TextInput type="month" value={billingMonth} onChange={(e) => setBillingMonth(e.target.value)} required />
          </Field>
        </div>

        {/* Line items — inline rows: Category · Description · Amount · remove. */}
        <div className="rounded-lg border border-border/50 bg-background/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">Line items</p>
            <button
              type="button"
              onClick={() => setLines((ls) => [...ls, emptyLine()])}
              className="rounded-md px-2 py-1 text-xs font-medium text-[var(--gold-dark)] transition hover:bg-amber-500/10"
            >
              + Add line
            </button>
          </div>
          <div className={`hidden gap-3 px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground md:grid ${COL_GRID}`}>
            <span>Category</span>
            <span>Description</span>
            <span>Amount (RM)</span>
            <span className="w-9" />
          </div>
          <div className="space-y-3">
            {lines.map((line, i) => {
              const badge = familyBadgeText(byId.get(line.categoryId)?.family);
              return (
                <div key={i} className={`grid grid-cols-1 gap-2 md:items-start md:gap-3 ${COL_GRID}`}>
                  <div>
                    <SelectInput aria-label="Category" value={line.categoryId} onChange={(e) => setLine(i, { categoryId: e.target.value })} required>
                      <option value="">Select category…</option>
                      {items.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </SelectInput>
                    {badge ? <Badge className="mt-1.5">{badge}</Badge> : null}
                  </div>
                  <TextInput
                    aria-label="Description"
                    placeholder="Description"
                    value={line.description}
                    onChange={(e) => setLine(i, { description: e.target.value })}
                    required
                  />
                  <TextInput
                    aria-label="Amount"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="0.00"
                    value={line.amount}
                    onChange={(e) => setLine(i, { amount: e.target.value })}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => removeLine(i)}
                    disabled={lines.length === 1}
                    aria-label="Remove line"
                    className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-rose-500/10 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </FormDrawer>
  );
}
