import { Field } from "@/components/form-ui";
import { Input } from "@/components/ui/input";

type Props = {
  bedrooms: string;
  bathrooms: string;
  parkingLots: string;
  expectedRental: string;
  purpose: "rent" | "own_stay";
  onChange: (patch: Partial<{
    bedrooms: string;
    bathrooms: string;
    parkingLots: string;
    expectedRental: string;
  }>) => void;
};

const BEDROOM_OPTIONS = [
  { value: "-1", label: "Studio" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4", label: "4+" },
];

const BATHROOM_OPTIONS = [
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3+" },
];

export function PropertyProfileSection(props: Props) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        Property profile
      </h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Bedrooms">
          <select
            value={props.bedrooms}
            onChange={(e) => props.onChange({ bedrooms: e.target.value })}
            className="w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm"
          >
            <option value="">—</option>
            {BEDROOM_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Bathrooms">
          <select
            value={props.bathrooms}
            onChange={(e) => props.onChange({ bathrooms: e.target.value })}
            className="w-full rounded-md border border-[var(--card-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-sm"
          >
            <option value="">—</option>
            {BATHROOM_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Parking lots">
          <Input
            type="number"
            min={0}
            max={20}
            value={props.parkingLots}
            onChange={(e) => props.onChange({ parkingLots: e.target.value })}
          />
        </Field>
      </div>
      {props.purpose === "rent" && (
        <Field
          label="Owner expected rental (RM/month)"
          hint="Required for rent-purpose units."
        >
          <Input
            type="number"
            step="0.01"
            min="0"
            value={props.expectedRental}
            onChange={(e) => props.onChange({ expectedRental: e.target.value })}
            placeholder="e.g. 3200"
          />
        </Field>
      )}
    </section>
  );
}
