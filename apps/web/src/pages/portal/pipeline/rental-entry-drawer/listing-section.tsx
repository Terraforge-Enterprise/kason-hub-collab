import { useQuery } from "@tanstack/react-query";
import { Field } from "@/components/form-ui";
import { Input } from "@/components/ui/input";
import { listPortalProperties } from "@/api/portal-inventory";

export type RentalEntryFields = {
  propertyId: string;
  unitCode: string;
  unitType: string;
  bedrooms: string;
  bathrooms: string;
  furnishingLevel: string;
  baseRentAmount: string;
  // Both deposit fields are mandatory; collected as strings to match the
  // rest of this form's pattern and converted to numbers in the submit handler.
  depositMonths: string;
  utilitiesDepositMonths: string;
  publishedTitle: string;
  publishedDescription: string;
};

const FURNISHING_OPTIONS = [
  { value: "", label: "—" },
  { value: "fully_furnished", label: "Fully Furnished" },
  { value: "partial", label: "Partially Furnished" },
  { value: "unfurnished", label: "Unfurnished" },
];

type Props = {
  value: RentalEntryFields;
  onChange: (patch: Partial<RentalEntryFields>) => void;
};

export function ListingSection({ value, onChange }: Props) {
  // listPortalProperties returns PortalProperty[] directly (not wrapped).
  // Existing-property only per Plan 1 carryover — no '+ New Property' UI.
  const { data } = useQuery({
    queryKey: ["portal-properties"],
    queryFn: () => listPortalProperties(),
  });
  const properties = data ?? [];

  return (
    <section className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Property">
          <select
            value={value.propertyId}
            onChange={(e) => onChange({ propertyId: e.target.value })}
            className="w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm"
          >
            <option value="">Select property…</option>
            {properties.map((p) => {
              // PropertySubmissions have `id=null` (pending admin approval);
              // skip them here — rental entries can only be filed against
              // approved Property rows.
              if (!p.id) return null;
              return (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.propertyCode}
                </option>
              );
            })}
          </select>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Need a new property? Ask admin to create it first.
          </p>
        </Field>
        <Field label="Unit code">
          <Input
            value={value.unitCode}
            onChange={(e) => onChange({ unitCode: e.target.value })}
            placeholder="e.g. A-12-01"
          />
        </Field>
        <Field label="Unit type">
          <Input
            value={value.unitType}
            onChange={(e) => onChange({ unitType: e.target.value })}
            placeholder="e.g. apartment"
          />
        </Field>
        <Field label="Bedrooms">
          <Input
            type="number"
            min={0}
            max={20}
            value={value.bedrooms}
            onChange={(e) => onChange({ bedrooms: e.target.value })}
          />
        </Field>
        <Field label="Bathrooms">
          <Input
            type="number"
            min={0}
            max={20}
            step="0.5"
            value={value.bathrooms}
            onChange={(e) => onChange({ bathrooms: e.target.value })}
          />
        </Field>
        <Field label="Furnishing">
          <select
            value={value.furnishingLevel}
            onChange={(e) => onChange({ furnishingLevel: e.target.value })}
            className="w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm"
          >
            {FURNISHING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Base rent (RM/month)">
          <Input
            type="number"
            min={0}
            step="0.01"
            value={value.baseRentAmount}
            onChange={(e) => onChange({ baseRentAmount: e.target.value })}
          />
        </Field>
        <Field label="Rental deposit (months) *">
          <Input
            type="number"
            min={0}
            max={24}
            step="0.5"
            required
            aria-required="true"
            value={value.depositMonths}
            onChange={(e) => onChange({ depositMonths: e.target.value })}
          />
        </Field>
        <Field label="Utilities deposit (months) *">
          <Input
            type="number"
            min={0}
            max={24}
            step="0.5"
            required
            aria-required="true"
            value={value.utilitiesDepositMonths}
            onChange={(e) => onChange({ utilitiesDepositMonths: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Listing title">
        <Input
          value={value.publishedTitle}
          onChange={(e) => onChange({ publishedTitle: e.target.value })}
          placeholder="e.g. Cozy 3-bed in KLCC"
        />
      </Field>
      <Field label="Description">
        <textarea
          value={value.publishedDescription}
          onChange={(e) => onChange({ publishedDescription: e.target.value })}
          rows={3}
          className="w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm"
        />
      </Field>
    </section>
  );
}
