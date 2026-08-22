import { Input } from "@/components/ui/input";

interface ParkingFieldsProps {
  parkingQuantity: number | null;
  parkingNumbers: string[];
  /** Optional per-bay rental rates. Create Unit supplies these so every bay is
   * immediately usable by the standalone Carpark tenancy flow. Older callers
   * may omit them and retain the compact quantity/label editor. */
  monthlyRates?: string[];
  onChange: (patch: {
    parkingQuantity: number | null;
    parkingNumbers: string[];
    monthlyRates?: string[];
  }) => void;
}

function resizeNumbers(qty: number, current: string[]): string[] {
  if (qty <= 0) return [];
  if (current.length === qty) return current;
  if (current.length > qty) return current.slice(0, qty);
  return [...current, ...Array.from({ length: qty - current.length }, () => "")];
}

export function ParkingFields(props: ParkingFieldsProps) {
  const { parkingQuantity, parkingNumbers, monthlyRates, onChange } = props;
  const qty = parkingQuantity ?? 0;

  function handleQuantityChange(raw: string) {
    if (raw === "") {
      onChange({
        parkingQuantity: null,
        parkingNumbers: [],
        ...(monthlyRates ? { monthlyRates: [] } : {}),
      });
      return;
    }
    const next = Number(raw);
    if (!Number.isFinite(next) || next < 0) return;
    onChange({
      parkingQuantity: next,
      parkingNumbers: resizeNumbers(next, parkingNumbers),
      ...(monthlyRates ? { monthlyRates: resizeNumbers(next, monthlyRates) } : {}),
    });
  }

  function handleSpotChange(idx: number, value: string) {
    const next = [...parkingNumbers];
    next[idx] = value;
    onChange({
      parkingQuantity: qty,
      parkingNumbers: next,
      ...(monthlyRates ? { monthlyRates } : {}),
    });
  }

  function handleRateChange(idx: number, value: string) {
    if (!monthlyRates) return;
    const next = resizeNumbers(qty, monthlyRates);
    next[idx] = value;
    onChange({ parkingQuantity: qty, parkingNumbers, monthlyRates: next });
  }

  return (
    <fieldset className="space-y-3 rounded-md border border-border p-4">
      <legend className="px-2 text-sm font-medium">Parking (optional)</legend>

      <label className="block max-w-xs">
        <span className="text-xs text-muted-foreground">Parking quantity</span>
        <Input
          type="number"
          min={0}
          max={20}
          value={parkingQuantity ?? ""}
          onChange={(e) => handleQuantityChange(e.target.value)}
        />
      </label>

      {qty > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Array.from({ length: qty }, (_, idx) => (
            <div key={idx} className="grid gap-2 sm:grid-cols-2 sm:col-span-2">
              <label className="block">
                <span className="text-xs text-muted-foreground">Spot {idx + 1}</span>
                <Input
                  value={parkingNumbers[idx] ?? ""}
                  placeholder="e.g. B2-145"
                  onChange={(e) => handleSpotChange(idx, e.target.value)}
                />
              </label>
              {monthlyRates && (
                <label className="block">
                  <span className="text-xs text-muted-foreground">Monthly rental (RM)</span>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={monthlyRates[idx] ?? ""}
                    placeholder="0.00"
                    onChange={(e) => handleRateChange(idx, e.target.value)}
                  />
                </label>
              )}
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}
