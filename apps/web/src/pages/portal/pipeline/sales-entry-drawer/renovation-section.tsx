import { useQuery } from "@tanstack/react-query";
import { Field } from "@/components/form-ui";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";
import { listPackages } from "@/api/portal-renovation-claims";

export type RenovationSplit = {
  partyPartyId?: string | null;
  partyDisplayName: string;
  roleLabel: string;
  splitType: "percent" | "fixed";
  splitValue: number;
  isHouseKeep?: boolean;
  sortOrder?: number;
};

export type RenovationInput = {
  packageId: string;
  packagePrice: number;
  paymentType: "full" | "partial" | "offset_from_rental";
  monthlyOffsetAmount?: number;
  splits: RenovationSplit[];
  notes?: string | null;
  documents?: Array<{ kind: string; fileKey: string; filename: string }>;
};

type Props = {
  value: RenovationInput | null;
  onChange: (next: RenovationInput | null) => void;
};

export function RenovationSection({ value, onChange }: Props) {
  const enabled = value !== null;
  const { data: packages = [] } = useQuery({
    queryKey: ["portal-renovation-packages"],
    queryFn: () => listPackages(),
    enabled,
  });

  function toggle(on: boolean) {
    if (on) {
      onChange({
        packageId: "",
        packagePrice: 0,
        paymentType: "full",
        splits: [
          { partyDisplayName: "House Keep", roleLabel: "House Keep", splitType: "percent", splitValue: 100, isHouseKeep: true, sortOrder: 0 },
        ],
      });
    } else {
      onChange(null);
    }
  }

  function patch(p: Partial<RenovationInput>) {
    if (value) onChange({ ...value, ...p });
  }

  function addSplit() {
    if (!value) return;
    onChange({
      ...value,
      splits: [
        ...value.splits,
        { partyDisplayName: "", roleLabel: "", splitType: "percent", splitValue: 0, sortOrder: value.splits.length },
      ],
    });
  }

  function updateSplit(idx: number, p: Partial<RenovationSplit>) {
    if (!value) return;
    onChange({ ...value, splits: value.splits.map((s, i) => (i === idx ? { ...s, ...p } : s)) });
  }

  function removeSplit(idx: number) {
    if (!value) return;
    onChange({ ...value, splits: value.splits.filter((_, i) => i !== idx) });
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Renovation
      </h3>
      <Segmented
        value={enabled ? "yes" : "no"}
        onChange={(v) => toggle(v === "yes")}
        options={[
          { value: "no", label: "No renovation" },
          { value: "yes", label: "Yes — file renovation claim" },
        ]}
        ariaLabel="Renovation"
      />
      {value && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Package">
              <select
                value={value.packageId}
                onChange={(e) => {
                  const pkg = packages.find((p) => p.id === e.target.value);
                  patch({
                    packageId: e.target.value,
                    packagePrice: pkg ? Number(pkg.defaultPrice) : 0,
                  });
                }}
                className="w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm"
              >
                <option value="">Select a package…</option>
                {packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Package price (RM)">
              <Input
                type="number"
                step="0.01"
                min="0"
                value={String(value.packagePrice)}
                onChange={(e) => patch({ packagePrice: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Field label="Payment type">
            <Segmented
              value={value.paymentType}
              onChange={(paymentType) => patch({ paymentType })}
              options={[
                { value: "full", label: "Full" },
                { value: "partial", label: "Partial" },
                { value: "offset_from_rental", label: "Offset from rental" },
              ]}
              ariaLabel="Payment type"
            />
          </Field>
          {value.paymentType === "offset_from_rental" && (
            <Field label="Monthly offset (RM)">
              <Input
                type="number"
                step="0.01"
                min="0"
                value={String(value.monthlyOffsetAmount ?? "")}
                onChange={(e) =>
                  patch({ monthlyOffsetAmount: Number(e.target.value) })
                }
              />
            </Field>
          )}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Splits
              </span>
              <Button variant="ghost" size="sm" onClick={addSplit}>
                <Plus className="h-3 w-3" /> Add row
              </Button>
            </div>
            <div className="space-y-2">
              {value.splits.map((s, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-2"
                >
                  <Input
                    value={s.roleLabel}
                    onChange={(e) => updateSplit(idx, { roleLabel: e.target.value })}
                    placeholder="Role label"
                    className="flex-1"
                  />
                  <Input
                    value={s.partyDisplayName}
                    onChange={(e) =>
                      updateSplit(idx, { partyDisplayName: e.target.value })
                    }
                    placeholder="Party display name"
                    className="flex-1"
                  />
                  <select
                    value={s.splitType}
                    onChange={(e) =>
                      updateSplit(idx, {
                        splitType: e.target.value as "percent" | "fixed",
                      })
                    }
                    className="rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2 py-1 text-sm"
                  >
                    <option value="percent">%</option>
                    <option value="fixed">RM</option>
                  </select>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={String(s.splitValue)}
                    onChange={(e) =>
                      updateSplit(idx, { splitValue: Number(e.target.value) })
                    }
                    className="w-24"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeSplit(idx)}
                    aria-label="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <Field label="Notes (optional)">
            <Input
              value={value.notes ?? ""}
              onChange={(e) => patch({ notes: e.target.value })}
            />
          </Field>
          <Callout variant="info">
            Renovation documents (quotation, invoice, agreement) can be uploaded
            after submitting via /portal/renovation-claims/:id.
          </Callout>
        </div>
      )}
    </section>
  );
}
