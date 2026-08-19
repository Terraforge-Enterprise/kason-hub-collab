import { Field } from "@/components/form-ui";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { PortalOwnerPicker } from "@/components/portal-owner-picker";

type Props = {
  unitNumber: string;
  ownerPartyId: string;
  ownerDisplayName: string;
  salesDate: string;
  purpose: "rent" | "own_stay";
  purchasePrice: string;
  onChange: (patch: Partial<{
    unitNumber: string;
    ownerPartyId: string;
    ownerDisplayName: string;
    salesDate: string;
    purpose: "rent" | "own_stay";
    purchasePrice: string;
  }>) => void;
};

export function UnitSection(props: Props) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Sale
      </h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Unit number">
          <Input
            value={props.unitNumber}
            onChange={(e) => props.onChange({ unitNumber: e.target.value })}
            placeholder="e.g. A-12-01"
          />
        </Field>
        <Field label="Owner">
          <PortalOwnerPicker
            value={props.ownerPartyId || null}
            displayName={props.ownerDisplayName}
            onChange={({ partyId, displayName }) =>
              props.onChange({ ownerPartyId: partyId, ownerDisplayName: displayName })
            }
          />
        </Field>
        <Field label="Sales date">
          <Input
            type="date"
            value={props.salesDate}
            onChange={(e) => props.onChange({ salesDate: e.target.value })}
          />
        </Field>
        <Field label="Purpose">
          <Segmented
            value={props.purpose}
            onChange={(purpose) => props.onChange({ purpose })}
            options={[
              { value: "own_stay", label: "Own Stay" },
              { value: "rent", label: "Rent Out" },
            ]}
            ariaLabel="Purpose"
          />
        </Field>
        <Field label="Purchase price (RM)">
          <Input
            type="number"
            step="0.01"
            min="0"
            value={props.purchasePrice}
            onChange={(e) => props.onChange({ purchasePrice: e.target.value })}
            placeholder="e.g. 850000"
          />
        </Field>
      </div>
    </section>
  );
}
